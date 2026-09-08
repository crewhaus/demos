#!/bin/sh
# The refund rule, in code, so no model gets to have an opinion about it.
#
#   ./bin/refund-window.sh <delivered YYYY-MM-DD> [today YYYY-MM-DD]
#
# Prints OPEN or CLOSED and the number of days elapsed. 30-day window,
# counted from delivery. Exits 2 on a malformed date so a wrong answer is
# never quietly produced.
set -eu

delivered=${1:-}
today=${2:-$(date -u +%Y-%m-%d)}

case "$delivered" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "usage: refund-window.sh <delivered YYYY-MM-DD> [today YYYY-MM-DD]" >&2; exit 2 ;;
esac
case "$today" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "refund-window.sh: bad date $today" >&2; exit 2 ;;
esac

days=$(python3 -c 'import sys,datetime
a=datetime.date.fromisoformat(sys.argv[1]); b=datetime.date.fromisoformat(sys.argv[2])
print((b-a).days)' "$delivered" "$today")

if [ "$days" -le 30 ] && [ "$days" -ge 0 ]; then
  echo "OPEN ($days days since delivery, 30-day window)"
else
  echo "CLOSED ($days days since delivery, 30-day window)"
fi
