#!/bin/sh
# Use the user's host login shell for an IDE terminal, preserving its arguments.
exec flatpak-spawn --host /bin/sh -c '
  host_shell=$(getent passwd "$(id -u)" | cut -d: -f7)
  test -n "$host_shell" || host_shell=/bin/sh
  exec "$host_shell" "$@"
' sidex-host-shell "$@"
