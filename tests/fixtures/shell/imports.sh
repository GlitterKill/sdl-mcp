#!/usr/bin/env bash

# Source command with relative path
source ./utils.sh

# Source command with absolute path
source /usr/local/lib/common.sh

# Dot notation with relative path
. ./helpers.sh

# Dot notation with absolute path
. /opt/scripts/functions.sh

# Source with parent directory relative path
source ../lib/config.sh

# Source with nested relative path
source ./lib/utils/logger.sh

# Dot notation with parent directory
. ../shared/constants.sh

# Source with quoted path
source "./quoted-path.sh"

# Dot with quoted path
. "./another-quoted.sh"

# Source with single quotes
source './single-quoted.sh'

# Dot with single quotes
. './single-dot-quoted.sh'

# Multiple source commands
source ./init.sh
source ./config.sh
. ./helpers.sh
