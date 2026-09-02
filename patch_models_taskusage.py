import re

with open('ios/Sources/CompanionCore/Models.swift', 'r') as f:
    content = f.read()

if 'public struct TaskUsage:' not in content:
    task_usage = """
public struct TaskUsage: Codable, Hashable, Sendable {
    public var input: Int
    public var output: Int
    public var cachedInput: Int?
    public var costUsd: Double?
    public var turns: Int
}
"""
    bot_task_regex = re.compile(r'(public struct BotTask: Codable, Hashable, Sendable \{.*?public var createdAt: Double)', re.DOTALL)
    bot_task_replacement = r'\1\n    public var usage: TaskUsage?'
    content = bot_task_regex.sub(bot_task_replacement, content)
    
    content = content.replace('public struct BotTask', task_usage.lstrip() + '\npublic struct BotTask')
    with open('ios/Sources/CompanionCore/Models.swift', 'w') as f2:
        f2.write(content)

