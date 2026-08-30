with open("electron/main.mjs", "r") as f:
    text = f.read()

text = text.replace('if (process.platform === "darwin") app.dock.setIcon(APP_ICON);', '// if (process.platform === "darwin") app.dock.setIcon(APP_ICON);')

with open("electron/main.mjs", "w") as f:
    f.write(text)
