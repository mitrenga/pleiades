#!/usr/bin/bash
# builds refemu (self-contained, no dependencies beyond libc)
cd "$(dirname "$0")"
gcc -O2 -Wall -Wextra -o refemu refemu.c
