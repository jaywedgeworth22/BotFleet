import re

with open("src/components/ErrorRow.tsx", "r") as f:
    content = f.read()

content = content.replace('import { Check, Settings, TerminalSquare } from "lucide-react";', 'import { AlertTriangle, RefreshCw } from "lucide-react";')
content = content.replace('import { cn } from "@/lib/utils";', '')
content = content.replace('import { CopyButton } from "./CopyButton";', '')
content = content.replace('import { useStore } from "@/state/store";', '')
content = content.replace('import { useMemo } from "react";', '')
content = content.replace('import { Bot, InstanceInfo } from "@/state/store";', 'import { InstanceInfo } from "@/state/store";')

with open("src/components/ErrorRow.tsx", "w") as f:
    f.write(content)
