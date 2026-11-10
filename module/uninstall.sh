#!/system/bin/sh
# Do not delete user data or alter a live mount. Reboot removes the bind mount.
printf '%s\n' 'Hosts Studio：配置及备份保留在 /data/adb/hosts_studio。' \
    '卸载完成后请重启。确认已卸载并重启、导出需要的备份后，可手动删除该目录。'
