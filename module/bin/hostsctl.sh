#!/system/bin/sh
# Fixed production paths; never accept state paths or shell from the WebUI.
BB=/data/adb/ksu/bin/busybox
if [ "${HOSTS_STUDIO_ASH:-}" != 1 ]; then
    if [ ! -x "$BB" ]; then
        printf '%s\n' '{"ok":false,"error":"KernelSU BusyBox is missing"}'
        exit 1
    fi
    export ASH_STANDALONE=1 HOSTS_STUDIO_ASH=1
    exec "$BB" sh "$0" "$@"
fi
export PATH=/data/adb/ksu/bin:/system/bin LC_ALL=C
umask 077
MODDIR=${0%/bin/hostsctl.sh}
STATE=/data/adb/hosts_studio
TARGET=$(readlink -f /system/etc/hosts)
BOOT_ID_FILE=/proc/sys/kernel/random/boot_id
. "$MODDIR/lib/core.sh"
[ "$(id -u)" = 0 ] || fail 'Root access is required'
[ "$TARGET" = /system/etc/hosts ] || [ "$TARGET" = /system/system/etc/hosts ] || fail 'Unsupported system hosts path'
main "$@"
