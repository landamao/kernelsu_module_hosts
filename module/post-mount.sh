#!/system/bin/sh
# Runs after metamodule mounting, before app startup. No network or background loop.
MODDIR=${0%/*}
BB=/data/adb/ksu/bin/busybox
# Refuse an isolated mount namespace rather than report a global mount that is not one.
SELF_NS=$("$BB" readlink /proc/self/ns/mnt)
INIT_NS=$("$BB" readlink /proc/1/ns/mnt)
if [ -z "$SELF_NS" ] || [ "$SELF_NS" != "$INIT_NS" ]; then
    printf '%s\n' 'Hosts Studio: post-mount is outside the init mount namespace; skipped.' >&2
    exit 1
fi
/system/bin/sh "$MODDIR/bin/hostsctl.sh" boot
