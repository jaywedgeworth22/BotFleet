import re

with open("server/vps-routing.test.ts", "r") as f:
    text = f.read()

old = """        DeviceRequests: [],"""
new = """        DeviceRequests: [],
        RestartPolicy: { Name: "unless-stopped" },
        CgroupnsMode: "private",
        SecurityOpt: [],"""
text = text.replace(old, new)

with open("server/vps-routing.test.ts", "w") as f:
    f.write(text)
