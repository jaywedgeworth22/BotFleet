import re
import os

with open("src/components/ChatView.tsx", "r") as f:
    chat_content = f.read()

# Extract ErrorRow function
error_row_match = re.search(r'(/\*\* A failed turn.*?function ErrorRow.*?\n\})\n\n(?:/\*\*|export|function|class)', chat_content, re.DOTALL)
if error_row_match:
    error_row_code = error_row_match.group(1)
    
    # We need to write ErrorRow to a new file, and include necessary imports
    with open("src/components/ErrorRow.tsx", "w") as f:
        f.write('''import { Bot, InstanceInfo } from "@/state/store";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";
import { Check, Settings, TerminalSquare } from "lucide-react";
import { useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { useMemo } from "react";

''' + error_row_code + '''

export { ErrorRow };
''')
    
    # Remove ErrorRow from ChatView.tsx
    chat_content = chat_content.replace(error_row_code, "")
    
    # Add import to ChatView.tsx
    import_statement = 'import { ErrorRow } from "./ErrorRow";\n'
    chat_content = chat_content.replace('import { ChatFindBar }', import_statement + 'import { ChatFindBar }')
    
    with open("src/components/ChatView.tsx", "w") as f:
        f.write(chat_content)
    print("Successfully extracted ErrorRow.")
else:
    print("Could not find ErrorRow.")

