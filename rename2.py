import os

extensions = ('.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.md', '.mdx', '.json', '.html', '.plist', '.yml', '.yaml', '.swift', '.txt', '.svg')

for root, _, files in os.walk('.'):
    if any(ignore in root.split(os.sep) for ignore in ['.git', 'node_modules', 'dist', 'build', '.next', 'ios/build']):
        continue
    for file in files:
        if file.endswith(extensions):
            path = os.path.join(root, file)
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            
            new_content = content.replace('OpenMausBot', 'BotFleet')
            new_content = new_content.replace('openmausbot', 'botfleet')
            new_content = new_content.replace('OPENMAUSBOT', 'BOTFLEET')
            
            # Additional replacement for "OpenMaus" and "openmaus" (e.g., OpenMausMobile -> BotFleetMobile, openmaus.team -> botfleet.team)
            new_content = new_content.replace('OpenMaus', 'BotFleet')
            new_content = new_content.replace('openmaus', 'botfleet')
            new_content = new_content.replace('OPENMAUS', 'BOTFLEET')
            
            if new_content != content:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f"Updated {path}")
