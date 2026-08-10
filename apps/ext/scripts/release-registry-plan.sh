#!/usr/bin/env bash

registry_publish_plan() {
    local marketplace_has_version="$1"
    local open_vsx_has_version="$2"

    [ "$marketplace_has_version" = "1" ] || printf '%s\n' "vsce"
    [ "$open_vsx_has_version" = "1" ] || printf '%s\n' "ovsx"
}
