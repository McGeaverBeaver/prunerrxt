import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatBytes } from '../../utils/format';
import {
  deleteFolder,
  getQualityProfiles,
  importFolder,
  listOrphanFolders,
  lookupCandidates,
  setFolderIgnored,
} from '../../services/orphanFolders';
import { DESTRUCTIVE, EXTERNAL_READ, MUTATING, defineTool, fail, ok } from '../helpers';

const describeError = (error: unknown) => fail(error instanceof Error ? error.message : String(error));

export function registerFolderTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_orphan_folders',
      title: 'List folders no app manages',
      description:
        "Folders inside Sonarr's and Radarr's root folders that belong to none of their series or movies: leftovers from manual moves, failed imports or titles removed without deleting files. Each comes with its parsed title/year, and with its size and contents when a folder mapping lets Prunerr see it. Follow up with lookup_orphan_folder + import_orphan_folder to bring one into the right app, or delete_orphan_folder to clean it up.",
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
        'Remove the folder and everything in it from disk. Needs a folder mapping so Prunerr can reach the files, and refuses anything that resolves outside the mapped media path. Irreversible; requires the "allow immediate deletion" setting and explicit confirmation from the user.',
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
