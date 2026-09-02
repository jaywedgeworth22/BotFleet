const fs = require('fs');
const content = fs.readFileSync('.github/workflows/ios-testflight.yml', 'utf8');
const fixed = content.replace(
`      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 8`,
`      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 8

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm`
);
fs.writeFileSync('.github/workflows/ios-testflight.yml', fixed);
