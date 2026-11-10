#!/system/bin/sh
MODDIR=${0%/*}
printf '%s\n' 'Hosts Studio 状态（此操作不会修改 hosts 或重启）' \
    '编辑：请在 KernelSU 模块页面打开 WebUI。' \
    '保存后需要手动重启。active 仅代表本次诊断所在命名空间。'
/system/bin/sh "$MODDIR/bin/hostsctl.sh" status
printf '%s\n' '配置/备份：/data/adb/hosts_studio' \
    '不生效时：检查是否启用其他 hosts 模块，以及目标应用的“卸载模块”设置。' \
    '禁用本模块并重启可恢复原来的系统 hosts。'
