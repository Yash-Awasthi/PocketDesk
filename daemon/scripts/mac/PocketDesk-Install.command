#!/bin/bash
# Double-click in Finder to install or update PocketDesk: runs install.sh from the release branch.
set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/install.sh | bash
echo
read -r -p "Done. Press Return to close this window." _
