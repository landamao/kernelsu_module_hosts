#!/system/bin/sh
SKIPUNZIP=0

[ "${KSU:-}" = true ] || abort '请使用官方 KernelSU 管理器安装此模块。'
# Source-verified support baseline, not a claim about the earliest hook version.
KSU_VERSION=${KSU_VER#v}
KSU_MAJOR=${KSU_VERSION%%.*}
case "$KSU_MAJOR" in ''|*[!0-9]*) abort '无法识别 KernelSU 版本，请更新官方 KernelSU。';; esac
[ "$KSU_MAJOR" -ge 3 ] || abort '需要官方 KernelSU 3.0.0 或更新版本。'

BB=/data/adb/ksu/bin/busybox
[ -x "$BB" ] || abort '找不到 KernelSU BusyBox。'
for applet in awk base64 sha256sum flock mount umount readlink od; do
    "$BB" --list | "$BB" grep -qx "$applet" || abort "缺少必需的 BusyBox 命令：$applet"
done
[ -x /system/bin/toybox ] || abort '找不到 Android toybox。'
[ -r /system/etc/hosts ] || abort '找不到可读取的系统 hosts 文件。'

ui_print '- Hosts Studio / 离线 hosts 编辑器'
ui_print '- 不修改系统分区；不设置网络代理；不下载规则'
set_perm_recursive "$MODPATH" 0 0 0755 0644
for script in customize.sh post-mount.sh action.sh uninstall.sh bin/hostsctl.sh; do
    set_perm "$MODPATH/$script" 0 0 0755
done
# Initialization is idempotent; module upgrades keep canonical data and backups.
/system/bin/sh "$MODPATH/bin/hostsctl.sh" init || abort '初始化失败：请检查上方错误；原系统 hosts 未改写。'
ui_print '- 配置保存在 /data/adb/hosts_studio，升级不会覆盖'
ui_print '- 请重启，然后在模块 WebUI 中编辑；每次保存后也需重启'
ui_print '- 请勿与其他 hosts 修改模块同时启用'
ui_print '- 卸载保留配置备份；禁用或卸载后重启恢复系统 hosts'
