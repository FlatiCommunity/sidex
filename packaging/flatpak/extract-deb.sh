#!/bin/sh
set -eu
archive=$1
member=$(ar t "$archive" | sed -n '/^data\.tar\(\.[a-z0-9]*\)\?$/p')
case "$member" in
  data.tar|data.tar.gz|data.tar.xz|data.tar.zst|data.tar.bz2|data.tar.lzma) ;;
  *) printf '%s\n' 'The Debian package must contain exactly one supported data.tar member.' >&2; exit 1 ;;
esac
ar p "$archive" "$member" > "$member"
tar -xf "$member"
rm "$member"
