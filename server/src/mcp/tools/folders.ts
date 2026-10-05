import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatBytes } from '../../utils/format';
import {
  deleteFolder,
  fixFolderPermissions,
  getQualityProfiles,
  inspectFolderPermissions,
  importFolder,
  listOrphanFolders,
  lookupCandidates,
  setFolderIgnored,
  setFoldersIgnored,
  suggestImports,
} from '../../services/orphanFolders';
import { cancelFolderBatch, enqueueFolderBatch, listFolderJobs } from '../../services/folderJobs';
import { DESTRUCTIVE, EXTERNAL_READ, MUTATING, defineTool, fail, ok } from '../helpers';
import { getPermissionCapabilities, getPermissionSettings } from '../../services/permissions';

const FolderIds = z.array(z.string().min(1)).min(1).max(500).describe('Folder ids from list_orphan_folders.');

const describeError = (error: unknown) => fail(error instanceof Error ? error.message : String(error));

export function registerFolderTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_orphan_folders',
      title: 'List folders no app manages',
      description:
        "Folders inside Sonarr's and Radarr's root folders that belong to none of their series or movies: leftovers from manual moves, failed imports or titles removed without deleting files. Each comes with its parsed title/year, and with its size and contents when a folder mapping lets PrunerrXT see it. Follow up with lookup_orphan_folder + import_orphan_folder to bring one into the right app, or delete_orphan_folder to clean it up.",
      group: 'folders',
      inputSchema: {
        includeIgnored: z.boolean().optional().describe('Also list folders the user chose to ignore.'),
        refresh: z.boolean().optional().describe('Re-read from the apps instead of the one-minute cache.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ includeIgnored, refresh }) => {
      try {
        const listing = await listOrphanFolders({ includeIgnored: includeIgnored === true, refresh: refresh === true });
        const folders = listing.folders.map((f) => ({
          id: f.id,
          service: f.serviceLabel,
          name: f.name,
          path: f.path,
          size: f.sizeBytes === null ? null : formatBytes(f.sizeBytes),
          sizeBytes: f.sizeBytes,
          fileCount: f.fileCount,
          videoFiles: f.videoFiles,
          modifiedAt: f.modifiedAt,
          guess: f.guess,
          canDelete: f.canDelete,
          permissionIssues: f.permissionIssues,
          writable: f.writable,
          ignored: f.ignored,
        }));
        const problems = listing.services.filter((s) => s.error).map((s) => `${s.serviceLabel}: ${s.error}`);
        return ok(
          { ...listing, folders },
          `${folders.length} unmanaged folder(s) (${formatBytes(listing.totalSizeBytes)} measured${listing.unsized > 0 ? `, ${listing.unsized} without a folder mapping so unsized` : ''}).${problems.length > 0 ? ` Problems: ${problems.join('; ')}` : ''}`
        );
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'lookup_orphan_folder',
      title: 'Find what a folder is',
      description:
        "Search the owning app's catalogue for the title a folder holds (best guess from the folder name, or your own search term) and list the matches with their TMDB/TVDB ids, plus the quality profiles available for an import.",
      group: 'folders',
      inputSchema: {
        id: z.string().min(1).describe('Folder id from list_orphan_folders.'),
        term: z.string().max(200).optional().describe('Override the automatic search term.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ id, term }) => {
      try {
        const result = await lookupCandidates(id, term);
        const profiles = await getQualityProfiles(result.folder.service);
        return ok(
          { ...result, qualityProfiles: profiles },
          `${result.candidates.length} match(es) for "${result.term}" in ${result.folder.serviceLabel}: ${result.candidates
            .slice(0, 5)
            .map((c) => `${c.title} (${c.year ?? '?'}) id ${c.id}${c.inLibrary ? ' [already in library]' : ''}`)
            .join('; ')}`
        );
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'import_orphan_folder',
      title: 'Import a folder into Sonarr/Radarr',
      description:
        'Add the chosen title to the app that owns the folder, with the folder as its path. The app scans it in place and takes over the files; nothing is moved. Confirm the candidate with the user first.',
      group: 'folders',
      inputSchema: {
        id: z.string().min(1).describe('Folder id from list_orphan_folders.'),
        candidateId: z.number().int().positive().describe('TMDB id (Radarr) or TVDB id (Sonarr) from lookup_orphan_folder.'),
        qualityProfileId: z.number().int().positive().optional().describe("Defaults to the app's first profile."),
        monitored: z.boolean().optional().describe('Default true.'),
      },
      annotations: MUTATING,
    },
    async ({ id, candidateId, qualityProfileId, monitored }) => {
      try {
        const result = await importFolder(id, { candidateId, qualityProfileId, monitored, actorName: 'MCP connector' });
        return ok(result, `Imported "${result.title}" (${result.year ?? '?'}) into ${result.folder.serviceLabel} as id ${result.addedId}; it is scanning ${result.folder.path} now.`);
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'delete_orphan_folder',
      title: 'Delete an unmanaged folder',
      description:
        'Remove the folder and everything in it from disk. Needs a folder mapping so PrunerrXT can reach the files, and refuses anything that resolves outside the mapped media path. Irreversible; requires the "allow immediate deletion" setting and explicit confirmation from the user.',
      group: 'folders',
      inputSchema: {
        id: z.string().min(1).describe('Folder id from list_orphan_folders.'),
      },
      annotations: DESTRUCTIVE,
      requiresImmediateDeletion: true,
    },
    async ({ id }) => {
      try {
        const result = await deleteFolder(id, { actorName: 'MCP connector' });
        return ok(result, `Deleted ${result.folder.path} (${result.fileCount} file(s), ${formatBytes(result.sizeBytes)} freed).`);
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'get_folder_permissions',
      title: 'Check a folder\'s ownership',
      description:
        "Who owns the files in an unmanaged folder and with what modes, compared with the owner and modes PrunerrXT is configured to apply (normally PUID:PGID, 0775/0664). Also reports who PrunerrXT runs as and whether it is able to change ownership. Files owned by another user are why a delete or an import fails with 'permission denied'.",
      group: 'folders',
      inputSchema: { id: z.string().min(1).describe('Folder id from list_orphan_folders.') },
      annotations: EXTERNAL_READ,
    },
    async ({ id }) => {
      try {
        const { folder, report } = await inspectFolderPermissions(id);
        const capabilities = getPermissionCapabilities();
        const settings = getPermissionSettings();
        return ok(
          { folder: { id: folder.id, name: folder.name, path: folder.path, localPath: folder.localPath }, report, capabilities, settings },
          `${folder.name}: ${report.checked} entries checked, ${report.wrongOwner} with the wrong owner, ${report.wrongMode} with the wrong mode, ${report.writable ? 'writable' : 'NOT writable'} by PrunerrXT (${capabilities.uid}:${capabilities.gid}). Target is ${settings.uid}:${settings.gid}, dirs ${settings.dirMode}, files ${settings.fileMode}.${capabilities.canChown ? '' : ` ${capabilities.reason}`}`
        );
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'fix_folder_permissions',
      title: 'Fix a folder\'s ownership and modes',
      description:
        'Set the configured owner (normally PUID:PGID) and modes on an unmanaged folder and everything in it, so it can be deleted here or imported and then managed by Sonarr/Radarr. Nothing is deleted or moved. Needs a folder mapping.',
      group: 'folders',
      inputSchema: { id: z.string().min(1).describe('Folder id from list_orphan_folders.') },
      annotations: MUTATING,
    },
    async ({ id }) => {
      try {
        const { folder, result } = await fixFolderPermissions(id, { actorName: 'MCP connector' });
        return ok(
          { folder: { id: folder.id, name: folder.name, path: folder.path }, result },
          `${folder.name}: ${result.changed} entries fixed, ${result.unchanged} already right, ${result.failed.length} failed${result.failed[0] ? ` (${result.failed[0].error})` : ''}.`
        );
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'preview_folder_imports',
      title: 'Match many folders to titles',
      description:
        "For each folder, the title it most plausibly is in the owning app's catalogue, with a confidence: exact (id tag, or title and year match), likely (title matches, no conflicting year), weak (best guess; check it) or none. Use it before run_folder_jobs with action import, and pass only the folders whose match you and the user accept. Up to 60 folders per call.",
      group: 'folders',
      inputSchema: { ids: z.array(z.string().min(1)).min(1).max(60).describe('Folder ids from list_orphan_folders.') },
      annotations: EXTERNAL_READ,
    },
    async ({ ids }) => {
      try {
        const suggestions = await suggestImports(ids);
        const counts = suggestions.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.confidence]: (acc[s.confidence] ?? 0) + 1 }), {});
        return ok(
          suggestions,
          `${suggestions.length} folder(s) matched: ${['exact', 'likely', 'weak', 'none'].map((c) => `${counts[c] ?? 0} ${c}`).join(', ')}.`
        );
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'run_folder_jobs',
      title: 'Import or fix permissions on many folders',
      description:
        'Queue background jobs for many unmanaged folders at once: import each into the app that owns it, or fix ownership and modes. Imports without a candidateId are matched automatically and only go ahead when the match is exact or likely; anything weaker fails with a reason and is left for an individual import. Returns at once; follow progress with list_folder_jobs. For deleting many folders use delete_orphan_folders.',
      group: 'folders',
      inputSchema: {
        action: z.enum(['import', 'fix_permissions']),
        folders: z
          .array(
            z.object({
              id: z.string().min(1),
              candidateId: z.number().int().positive().optional().describe('TMDB/TVDB id from preview_folder_imports or lookup_orphan_folder; omit to match automatically.'),
            })
          )
          .min(1)
          .max(500),
        qualityProfileId: z.number().int().positive().optional().describe("Imports only; defaults to the app's first profile."),
        monitored: z.boolean().optional().describe('Imports only; default true.'),
      },
      annotations: MUTATING,
    },
    async ({ action, folders, qualityProfileId, monitored }) => {
      try {
        const result = await enqueueFolderBatch({
          action,
          folders: folders.map((f) => ({ id: f.id, params: f.candidateId ? { candidateId: f.candidateId } : undefined })),
          params: { qualityProfileId, monitored },
          actorName: 'MCP connector',
        });
        return ok(result, `Batch ${result.batchId}: ${result.queued.length} job(s) queued, ${result.alreadyQueued} already in progress, ${result.skipped.length} skipped${result.skipped[0] ? ` (${result.skipped[0].error})` : ''}.`);
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'delete_orphan_folders',
      title: 'Delete many unmanaged folders',
      description:
        'Queue background deletions of many unmanaged folders. Each needs a folder mapping and is re-checked as still unmanaged just before it goes. Irreversible; requires the "allow immediate deletion" setting and explicit confirmation from the user, listing what will be removed. Returns at once; follow progress with list_folder_jobs, stop the rest with cancel_folder_batch.',
      group: 'folders',
      inputSchema: { ids: FolderIds },
      annotations: DESTRUCTIVE,
      requiresImmediateDeletion: true,
    },
    async ({ ids }) => {
      try {
        const result = await enqueueFolderBatch({ action: 'delete', folders: ids.map((id) => ({ id })), actorName: 'MCP connector' });
        const bytes = result.queued.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0);
        return ok(result, `Batch ${result.batchId}: ${result.queued.length} deletion(s) queued (${formatBytes(bytes)}), ${result.alreadyQueued} already in progress, ${result.skipped.length} skipped${result.skipped[0] ? ` (${result.skipped[0].error})` : ''}.`);
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'list_folder_jobs',
      title: 'Progress of folder batches',
      description: 'Background folder jobs (delete, import, fix permissions): what is running, what finished recently and per-batch totals.',
      group: 'folders',
      inputSchema: {},
      annotations: EXTERNAL_READ,
    },
    async () => {
      const listing = listFolderJobs(100);
      return ok(
        listing,
        listing.batches.length === 0
          ? 'No folder jobs.'
          : listing.batches
              .slice(0, 5)
              .map((b) => `${b.action} batch ${b.batchId.slice(0, 8)}: ${b.done}/${b.total} done, ${b.running} running, ${b.pending} pending, ${b.failed} failed`)
              .join('; ')
      );
    }
  );

  defineTool(
    server,
    {
      name: 'cancel_folder_batch',
      title: 'Stop a folder batch',
      description: 'Cancel every job in a batch that has not started yet. The job running right now finishes on its own.',
      group: 'folders',
      inputSchema: { batchId: z.string().min(1).describe('From run_folder_jobs, delete_orphan_folders or list_folder_jobs.') },
      annotations: MUTATING,
    },
    async ({ batchId }) => {
      const result = cancelFolderBatch(batchId);
      return ok(result, `${result.cancelled} pending job(s) cancelled.`);
    }
  );

  defineTool(
    server,
    {
      name: 'ignore_orphan_folders',
      title: 'Ignore or unignore many folders',
      description: 'Hide many folders from the orphan list (or bring them back) in one go. Nothing on disk changes.',
      group: 'folders',
      inputSchema: { ids: FolderIds, ignored: z.boolean().optional().describe('Default true.') },
      annotations: MUTATING,
    },
    async ({ ids, ignored }) => {
      try {
        const result = await setFoldersIgnored(ids, ignored !== false, 'MCP connector');
        return ok(result, `${result.folders.length} folder(s) ${ignored !== false ? 'ignored' : 'listed again'}${result.missing.length > 0 ? `, ${result.missing.length} not found` : ''}.`);
      } catch (error) {
        return describeError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'ignore_orphan_folder',
      title: 'Ignore or unignore a folder',
      description: 'Hide a folder from the orphan list (or bring it back). Nothing on disk changes.',
      group: 'folders',
      inputSchema: {
        id: z.string().min(1),
        ignored: z.boolean().optional().describe('Default true.'),
      },
      annotations: MUTATING,
    },
    async ({ id, ignored }) => {
      try {
        const folder = await setFolderIgnored(id, ignored !== false, 'MCP connector');
        return ok(folder, `${folder.name} is now ${folder.ignored ? 'ignored' : 'listed again'}.`);
      } catch (error) {
        return describeError(error);
      }
    }
  );
}
