# Sourced by the fixed-path root entry point. All configuration is data, not code.
MAX_BYTES=262144
MAX_CHUNK=12288

json_string() {
    printf '%s' "$1" | awk 'BEGIN { printf "\"" }
    { if (NR > 1) printf "\\n"; for (j=1;j<=length($0);j++) {
        c=substr($0,j,1)
        if (c=="\\") printf "\\\\"; else if (c=="\"") printf "\\\""
        else if (c=="\t") printf "\\t"; else if (c=="\r") printf "\\r"
        else if (c ~ /[[:cntrl:]]/) printf "?"; else printf "%s",c
    }} END { printf "\"" }'
}

fail() {
    printf '{"ok":false,"error":'
    json_string "$1"
    printf '}\n'
    exit 1
}

size_of() { wc -c < "$1" | tr -d '[:space:]'; }
hash_of() { sha256sum "$1" | cut -d ' ' -f 1; }

is_hash() {
    [ "${#1}" -eq 64 ] || return 1
    case "$1" in *[!a-f0-9]*) return 1;; esac
}

is_id() {
    [ "${#1}" -eq 24 ] || return 1
    case "$1" in *[!a-f0-9]*) return 1;; esac
}

safe_file() { [ -f "$1" ] && [ ! -L "$1" ]; }

validate_to() {
    input=$1
    output=$2
    safe_file "$input" || fail 'Input is not a regular file'
    count=$(size_of "$input")
    [ "$count" -gt 0 ] && [ "$count" -le "$MAX_BYTES" ] || fail 'Hosts must contain 1 to 262144 bytes'
    tr -d '\000' < "$input" > "$STATE/.nonul" || fail 'Cannot inspect input'
    [ "$(size_of "$STATE/.nonul")" = "$count" ] || fail 'NUL bytes are not allowed'
    awk '{ sub(/\r$/, ""); print }' "$input" > "$output" || fail 'Cannot normalize input'
    [ "$(size_of "$output")" -le "$MAX_BYTES" ] || fail 'Normalized hosts exceeds 262144 bytes'
    reason=$(awk -f "$MODDIR/lib/validate.awk" "$output" 2>&1) || fail "$reason"
}

check_revision() {
    is_hash "$1" || fail 'Invalid revision'
    [ "$1" = "$(hash_of "$STATE/config/hosts")" ] || fail 'Hosts changed since loading. Reload before saving.'
}

prepare_state() {
    [ ! -L "$STATE" ] || fail 'State directory cannot be a symbolic link'
    [ -d "$STATE" ] || mkdir -m 700 "$STATE" || fail 'Cannot create state directory'
    chmod 700 "$STATE" || fail 'Cannot protect state directory'
    for part in config backups runtime upload; do
        [ ! -L "$STATE/$part" ] || fail 'Unsafe state subdirectory'
        [ -d "$STATE/$part" ] || mkdir -m 700 "$STATE/$part" || fail 'Cannot create state subdirectory'
        chmod 700 "$STATE/$part" || fail 'Cannot protect state subdirectory'
    done
    for name in .lock .nonul .candidate .incoming .previous .original .boot.new .boot boot-id; do
        [ ! -L "$STATE/$name" ] || fail 'Unsafe state file'
    done
    for name in config/hosts backups/original backups/previous runtime/hosts upload/id upload/revision upload/next upload/data upload/chunk; do
        [ ! -L "$STATE/$name" ] || fail 'Unsafe state file'
    done
}

lock_state() {
    exec 9> "$STATE/.lock" || fail 'Cannot open state lock'
    flock -n 9 || fail 'Another operation is in progress. Try again.'
    trap 'rm -f "$STATE/.nonul" "$STATE/.candidate" "$STATE/.incoming" "$STATE/.previous" "$STATE/.original" "$STATE/.boot.new"' EXIT
}

require_config() {
    safe_file "$STATE/config/hosts" && safe_file "$STATE/backups/original" || fail 'Configuration is missing. Reinstall the module.'
}

initialize() {
    safe_file "$STATE/config/hosts" && safe_file "$STATE/backups/original" && return 0
    # Preserve a validated original exactly once, including across upgrades.
    if [ ! -e "$STATE/backups/original" ]; then
        validate_to "$TARGET" "$STATE/.original"
        chmod 600 "$STATE/.original" || fail 'Cannot protect original backup'
        mv "$STATE/.original" "$STATE/backups/original" || fail 'Cannot save original backup'
    fi
    if [ ! -e "$STATE/config/hosts" ]; then
        cp "$STATE/backups/original" "$STATE/.candidate" || fail 'Cannot initialize hosts'
        chmod 600 "$STATE/.candidate" || fail 'Cannot protect hosts'
        mv "$STATE/.candidate" "$STATE/config/hosts" || fail 'Cannot initialize hosts'
    fi
    require_config
}

save_candidate() {
    cp "$STATE/config/hosts" "$STATE/.previous" || fail 'Cannot prepare previous backup'
    chmod 600 "$STATE/.previous" "$STATE/.candidate" || fail 'Cannot protect saved files'
    mv "$STATE/.previous" "$STATE/backups/previous" || fail 'Cannot save previous backup'
    mv "$STATE/.candidate" "$STATE/config/hosts" || fail 'Cannot save hosts'
    printf '{"ok":true,"revision":"%s","bytes":%s,"pending":true}\n' \
        "$(hash_of "$STATE/config/hosts")" "$(size_of "$STATE/config/hosts")"
}

clear_upload() {
    rm -f "$STATE/upload/id" "$STATE/upload/revision" "$STATE/upload/next" "$STATE/upload/data" "$STATE/upload/chunk"
}

check_upload() {
    is_id "$1" || fail 'Invalid upload id'
    safe_file "$STATE/upload/id" || fail 'Upload expired. Save again.'
    [ "$1" = "$(cat "$STATE/upload/id")" ] || fail 'Another editor started an upload. Save again.'
}

status_json() {
    configured=false
    active=false
    pending=true
    backup=false
    bytes=0
    message='Not mounted in this boot; reboot after installation.'
    bootid=$(cat "$BOOT_ID_FILE")
    if safe_file "$STATE/config/hosts"; then configured=true; bytes=$(size_of "$STATE/config/hosts"); fi
    safe_file "$STATE/backups/previous" && backup=true
    if safe_file "$STATE/boot-id" && [ "$(cat "$STATE/boot-id")" = "$bootid" ]; then
        safe_file "$STATE/.boot" && message=$(cat "$STATE/.boot")
        # Inode identity checks the calling namespace, not all app namespaces.
        if safe_file "$STATE/runtime/hosts" && [ "$TARGET" -ef "$STATE/runtime/hosts" ]; then
            active=true
            message='Mounted in the current namespace. App visibility may differ.'
            if $configured && cmp -s "$STATE/config/hosts" "$STATE/runtime/hosts"; then pending=false; fi
        fi
    fi
    printf '{"ok":true,"configured":%s,"active":%s,"pending":%s,"backup":%s,"bytes":%s,"bootMessage":' \
        "$configured" "$active" "$pending" "$backup" "$bytes"
    json_string "$message"
    printf ',"bootId":'
    json_string "$bootid"
    printf '}\n'
}

boot_message() {
    printf '%s\n' "$1" > "$STATE/.boot.new" && mv "$STATE/.boot.new" "$STATE/.boot"
}

mount_hosts() {
    current_boot=$(cat "$BOOT_ID_FILE")
    if safe_file "$STATE/boot-id" && [ "$(cat "$STATE/boot-id")" = "$current_boot" ]; then
        status_json
        return
    fi
    printf '%s\n' "$current_boot" > "$STATE/boot-id" || fail 'Cannot record boot id'
    boot_message 'Mount did not complete; check the KernelSU module boot log.'
    validate_to "$STATE/config/hosts" "$STATE/.candidate"
    # Never overwrite a live bound inode. This command runs once, at early boot.
    [ ! "$TARGET" -ef "$STATE/runtime/hosts" ] || fail 'Existing hosts mount detected; reboot required'
    context=$(ls -Zd "$TARGET" 2>/dev/null | grep -o 'u:object_r:[^[:space:]]*' | cut -d ' ' -f 1)
    case "$context" in u:object_r:*:s0*) ;; *) fail 'Cannot determine original SELinux context';; esac
    cp "$STATE/.candidate" "$STATE/runtime/hosts" || fail 'Cannot prepare runtime hosts'
    chown 0:0 "$STATE/runtime/hosts" && chmod 644 "$STATE/runtime/hosts" || fail 'Cannot set runtime file permissions'
    /system/bin/toybox chcon "$context" "$STATE/runtime/hosts" || fail 'Cannot apply the original SELinux context'
    mount -o bind "$STATE/runtime/hosts" "$TARGET" || fail 'Cannot bind mount hosts; system hosts was not rewritten'
    if ! mount -o remount,bind,ro "$STATE/runtime/hosts" "$TARGET"; then
        if umount "$TARGET"; then
            boot_message 'Read-only remount failed; original hosts restored.'
        else
            boot_message 'Read-only remount and rollback failed; disable module and reboot.'
        fi
        fail 'Read-only bind remount failed. Check boot status.'
    fi
    boot_message 'Mounted at post-mount stage. Changes require reboot.'
    status_json
}

main() {
    command=${1:-}
    [ "$#" -gt 0 ] && shift
    case "$command" in
        init|read|status|boot) [ "$#" -eq 0 ] || fail 'Unexpected arguments';;
        stage-begin|stage-commit|stage-abort|restore-backup|restore-original) [ "$#" -eq 1 ] || fail 'Expected one argument';;
        stage-append) [ "$#" -eq 3 ] || fail 'Expected upload id, index and base64 data';;
        *) fail 'Unknown command';;
    esac
    prepare_state
    lock_state
    case "$command" in
        init) initialize; printf '{"ok":true}\n'; return;;
        status) status_json; return;;
    esac
    require_config
    case "$command" in
        read)
            printf '{"ok":true,"revision":"%s","content":"' "$(hash_of "$STATE/config/hosts")"
            base64 < "$STATE/config/hosts" | tr -d '\n'
            printf '"}\n'
            ;;
        stage-begin)
            check_revision "$1"
            clear_upload
            id=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
            is_id "$id" || fail 'Cannot generate upload id'
            printf '%s' "$id" > "$STATE/upload/id" && printf '%s' "$1" > "$STATE/upload/revision" && \
                printf '0' > "$STATE/upload/next" && : > "$STATE/upload/data" || fail 'Cannot start upload'
            printf '{"ok":true,"id":"%s"}\n' "$id"
            ;;
        stage-append)
            check_upload "$1"
            case "$2" in ''|*[!0-9]*|0[0-9]*) fail 'Invalid chunk index';; esac
            [ "${#2}" -le 3 ] && [ "$2" = "$(cat "$STATE/upload/next")" ] || fail 'Unexpected chunk index'
            [ "${#3}" -gt 0 ] && [ "${#3}" -le "$MAX_CHUNK" ] || fail 'Invalid chunk size'
            case "$3" in *[!A-Za-z0-9+/=]*) fail 'Invalid base64 data';; esac
            printf '%s' "$3" | base64 -d > "$STATE/upload/chunk" || fail 'Invalid base64 encoding'
            [ "$(base64 < "$STATE/upload/chunk" | tr -d '\n')" = "$3" ] || fail 'Non-canonical base64 data'
            total=$(( $(size_of "$STATE/upload/data") + $(size_of "$STATE/upload/chunk") ))
            [ "$total" -le "$MAX_BYTES" ] || fail 'Hosts exceeds 262144 bytes'
            # Replace the staged file, so a failed append cannot corrupt its prefix.
            cat "$STATE/upload/data" "$STATE/upload/chunk" > "$STATE/.incoming" || fail 'Cannot stage chunk'
            mv "$STATE/.incoming" "$STATE/upload/data" || fail 'Cannot stage chunk'
            next=$(( $2 + 1 ))
            printf '%s' "$next" > "$STATE/upload/next" || fail 'Cannot record chunk index'
            printf '{"ok":true,"next":%s}\n' "$next"
            ;;
        stage-commit)
            check_upload "$1"
            check_revision "$(cat "$STATE/upload/revision")"
            validate_to "$STATE/upload/data" "$STATE/.candidate"
            save_candidate
            clear_upload
            ;;
        stage-abort)
            check_upload "$1"
            clear_upload
            printf '{"ok":true}\n'
            ;;
        restore-backup|restore-original)
            check_revision "$1"
            if [ "$command" = restore-backup ]; then source_file="$STATE/backups/previous"; else source_file="$STATE/backups/original"; fi
            validate_to "$source_file" "$STATE/.candidate"
            save_candidate
            ;;
        boot) mount_hosts;;
    esac
}
