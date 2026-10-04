import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config', () => ({
  default: { dbPath: '/app/data/prunerr.db' },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseMountInfo, selectMediaMounts } from '../containerMounts';

// A Docker container on Unraid: root overlay, the usual pseudo filesystems,
// the files Docker binds in, the data volume, and three media mounts (one
// read-only, one on a fuse share, one whose path has a space).
const MOUNTINFO = `
1046 1032 0:245 / / rw,relatime master:409 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/x/diff,workdir=/var/lib/docker/overlay2/x/work
1047 1046 0:248 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
1048 1046 0:249 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
1049 1048 0:250 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
1050 1046 0:251 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
1051 1050 0:252 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw
1052 1048 0:247 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
1053 1048 0:253 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k
1054 1046 0:37 /user/appdata/prunerr /app/data rw,relatime - fuse.shfs shfs rw,user_id=0,group_id=0,allow_other
1055 1046 8:17 /media /media rw,relatime - xfs /dev/sdb1 rw,attr2,inode64
1056 1046 0:37 /user/tv /tv ro,relatime - fuse.shfs shfs rw,user_id=0,group_id=0,allow_other
1057 1046 8:33 /My\\040Movies /mnt/my\\040movies rw,relatime - ext4 /dev/sdc1 rw
1058 1046 254:1 /var/lib/docker/containers/abc/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw
1059 1046 254:1 /var/lib/docker/containers/abc/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw
1060 1046 254:1 /var/lib/docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw
1061 1046 0:260 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k
`;

describe('container mount detection', () => {
  it('parses mountinfo lines, including escaped spaces and read-only flags', () => {
    const parsed = parseMountInfo(MOUNTINFO);
    expect(parsed.length).toBe(16);
    const tv = parsed.find((m) => m.mountPoint === '/tv');
    expect(tv).toEqual({ mountPoint: '/tv', fsType: 'fuse.shfs', source: 'shfs', readOnly: true });
    const spaced = parsed.find((m) => m.mountPoint === '/mnt/my movies');
    expect(spaced).toMatchObject({ fsType: 'ext4', source: '/dev/sdc1', readOnly: false });
  });

  it('keeps only the volumes a user could have mapped media into', () => {
    const mounts = selectMediaMounts(parseMountInfo(MOUNTINFO), ['/app', '/app/data']);
    expect(mounts.map((m) => m.mountPoint)).toEqual(['/media', '/mnt/my movies', '/tv']);
  });

  it('uses the latest line for a mount point mounted twice', () => {
    const twice = `
1 0 8:1 / /media ro,relatime - ext4 /dev/sda1 ro
2 0 8:2 / /media rw,relatime - ext4 /dev/sdb1 rw
`;
    const mounts = selectMediaMounts(parseMountInfo(twice), []);
    expect(mounts).toEqual([{ mountPoint: '/media', fsType: 'ext4', source: '/dev/sdb1', readOnly: false }]);
  });

  it('ignores malformed lines', () => {
    expect(parseMountInfo('garbage\n\n1 2 3\n')).toEqual([]);
  });
});
