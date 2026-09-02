with open("src/components/GroupView.tsx", "r") as f:
    content = f.read()

import_statement = 'import { ErrorRow } from "./ErrorRow";\n'
content = content.replace('import { ChatFindBar }', import_statement + 'import { ChatFindBar }')

replace_target = '''          ) : m.kind === "activity" && m.tool ? (
            m.tool.ok === false || m.tool.name.startsWith("error:") || showToolCalls ? (
              <RoomToolChip message={m} />
            ) : null
          ) : m.kind === "text" && m.text ? ('''

replace_with = '''          ) : m.kind === "activity" && m.tool ? (
            m.tool.name.startsWith("error:") ? (
              <div className="flex justify-start max-w-full">
                <ErrorRow 
                  message={m.tool.name.slice(6).trim()} 
                  onRetry={() => {}} 
                />
              </div>
            ) : m.tool.ok === false || showToolCalls ? (
              <RoomToolChip message={m} />
            ) : null
          ) : m.kind === "text" && m.text ? ('''

content = content.replace(replace_target, replace_with)

with open("src/components/GroupView.tsx", "w") as f:
    f.write(content)
