#!/bin/bash
# Double-click in Finder to remove PocketDesk. Paired phones and settings stay unless you add --purge.
set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/uninstall.sh | bash
echo
read -r -p "Done. Press Return to close this window." _
