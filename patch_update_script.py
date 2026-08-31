with open("/Users/jay/apps/update-botfleet.sh", "r") as f:
    text = f.read()

old_code = """echo "🗑️ Moving old BotFleet to Trash..."
osascript -e 'tell application "Finder" to delete POSIX file "/Applications/BotFleet.app"' || true"""

new_code = """echo "🛑 Closing running BotFleet application..."
osascript -e 'tell application "BotFleet" to quit' || true
sleep 2
pkill -9 -f "BotFleet.app" || true

echo "🗑️ Moving old BotFleet to Trash..."
osascript -e 'tell application "Finder" to delete POSIX file "/Applications/BotFleet.app"' || true"""

text = text.replace(old_code, new_code)

with open("/Users/jay/apps/update-botfleet.sh", "w") as f:
    f.write(text)
