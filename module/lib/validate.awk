# Portable AWK: syntax validation only; never evaluate hosts content.
function invalid(reason) {
    printf "Line %d: %s\n", NR, reason > "/dev/stderr"
    bad = 1
    exit 1
}
function ipv4(value, parts, count, i) {
    count = split(value, parts, ".")
    if (count != 4) return 0
    for (i = 1; i <= count; i++) {
        if (parts[i] !~ /^[0-9]+$/ || length(parts[i]) > 3 || parts[i] + 0 > 255) return 0
        if (length(parts[i]) > 1 && substr(parts[i], 1, 1) == "0") return 0
    }
    return 1
}
function groups(value, parts, count, i) {
    if (value == "") return 0
    count = split(value, parts, ":")
    for (i = 1; i <= count; i++) {
        if (parts[i] !~ /^[0-9a-fA-F]+$/ || length(parts[i]) > 4) return -100
    }
    return count
}
function ipv6(value, pos, left, right, last, suffix, i, total) {
    # An embedded dotted IPv4 tail occupies two hextets.
    if (index(value, ".")) {
        last = 0
        for (i = 1; i <= length(value); i++) if (substr(value, i, 1) == ":") last = i
        if (!last) return 0
        suffix = substr(value, last + 1)
        if (!ipv4(suffix)) return 0
        value = substr(value, 1, last) "0:0"
    }
    if (value !~ /^[0-9a-fA-F:]+$/) return 0
    pos = index(value, "::")
    if (!pos) return groups(value) == 8
    left = substr(value, 1, pos - 1)
    right = substr(value, pos + 2)
    if (index(right, "::")) return 0
    left = groups(left)
    right = groups(right)
    if (left < 0 || right < 0) return 0
    total = left + right
    return total < 8
}
function hostname(value, parts, count, i) {
    if (substr(value, length(value), 1) == ".") value = substr(value, 1, length(value) - 1)
    if (!length(value) || length(value) > 253) return 0
    count = split(value, parts, ".")
    for (i = 1; i <= count; i++) {
        if (!length(parts[i]) || length(parts[i]) > 63 || parts[i] !~ /^[A-Za-z0-9_][A-Za-z0-9_-]*$/) return 0
        if (substr(parts[i], length(parts[i]), 1) == "-") return 0
    }
    return 1
}
{
    if (length($0) > 4096) invalid("line exceeds 4096 bytes")
    if ($0 ~ /[\001-\010\013-\037\177]/) invalid("control character is not allowed")
    sub(/#.*/, "")
    if ($0 ~ /^[ \t]*$/) next
    if (NF < 2) invalid("expected IP address and at least one hostname")
    if (!ipv4($1) && !ipv6($1)) invalid("invalid IPv4 or IPv6 address")
    for (i = 2; i <= NF; i++) if (!hostname($i)) invalid("invalid hostname; URLs and wildcards are not supported")
    entries++
}
END {
    if (!bad && !entries) {
        print "At least one valid IP / hostname entry is required" > "/dev/stderr"
        exit 1
    }
}
