import os
import re

dirs_to_search = ['src', 'server', 'electron', 'apps', 'companion', 'cloudflare', 'scripts', 'package.json']
extensions = ('.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.md', '.mdx', '.json', '.html', '.plist')

for root, _, files in os.walk('.'):
    if any(ignore in root.split(os.sep) for ignore in ['.git', 'node_modules', 'dist', 'build', '.next']):
        continue
    for file in files:
        if file.endswith(extensions):
            path = os.path.join(root, file)
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            
            new_content = content.replace('BotFleet', 'BotFleet')
            new_content = new_content.replace('botfleet', 'botfleet')
            new_content = new_content.replace('BOTFLEET', 'BOTFLEET')
            
            if new_content != content:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f"Updated {path}")
