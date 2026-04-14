/**
 * ASCII art banner for SDL-MCP CLI output.
 * Cyberpunk/tech themed "Glitch Matrix" style.
 */

const BANNER = `
┌──────────────────────────────────────────────────────────────────────────────┐
│ ░▒▓█ S Y S T E M :: I N I T I A L I Z I N G █▓▒░                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ╭━━━╮╱╱╱╭━━━╮╱╱╱╭╮╱╱╱╱╱╱╱╱╱╭━╮╭━╮╭━━━╮╭━━━╮                                │
│   ┃╭━╮┃╱╱╱╰╮╭╮┃╱╱╱┃┃╱╱╱╱╱╱╱╱╱┃┃╰╯┃┃┃╭━╮┃┃╭━╮┃                                │
│   ┃╰━━╮╱╱╱╱┃┃┃┃╱╱╱┃┃╱╱╱╱╱╱╱╱╱┃╭╮╭╮┃┃┃╱╰╯┃╰━╯┃                                │
│   ╰━━╮┃╱╱╱╱┃┃┃┃╱╱╱┃┃╱╱╭━━━╮╱╱┃┃┃┃┃┃┃┃╱╭╮┃╭━━╯                                │
│   ┃╰━╯┃╱╱╱╭╯╰╯┃╱╱╱┃╰━╮╰━━━╯╱╱┃┃┃┃┃┃┃╰━╯┃┃┃                                   │
│   ╰━━━╯╱╱╱╰━━━╯╱╱╱╰━━╯╱╱╱╱╱╱╱╰╯╰╯╰╯╰━━━╯╰╯                                   │
│                                                                              │
│   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                  │
│   01001101 01000011 01010000  << NEURAL LINK ACTIVE >>                       │
└──────────────────────────────────────────────────────────────────────────────┘
`;

/**
 * Print the SDL-MCP banner to stderr (so it doesn't interfere with MCP JSON output).
 */
export function printBanner(): void {
  console.error(BANNER);
}

/**
 * Get the banner string without printing.
 */
export function getBanner(): string {
  return BANNER;
}
