import json, os

bots_path = os.path.expanduser('~/.botfleet/bots.json')
with open(bots_path, 'r') as f:
    bots = json.load(f)

changed = False
for bot in bots:
    if bot.get('modelSelection', {}).get('instanceId') == 'codex':
        bot['modelSelection']['instanceId'] = 'antigravity'
        bot['modelSelection']['model'] = 'gemini-2.5-pro'
        bot['lastInstanceId'] = 'antigravity'
        changed = True

if changed:
    with open(bots_path, 'w') as f:
        json.dump(bots, f, indent=2)
    print("Patched")
