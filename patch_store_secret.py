import re

with open('server/store.ts', 'r') as f:
    content = f.read()

# Replace SecretRequestCardData target
new_target = """export interface SecretRequestCardData {
  /** Fixed allowlisted credential id, or a custom secret requested by a bot. */
  target: import("../shared/credential-request.ts").CredentialTargetId | { custom: string };
  label: string;
  description: string;
  placeholder: string;
  helpUrl?: string;"""

content = re.sub(r'export interface SecretRequestCardData \{\n  /\*\* Fixed allowlisted credential id; never an arbitrary config path\. \*/\n  target: import\("\.\./shared/credential-request\.ts"\)\.CredentialTargetId;\n  label: string;\n  description: string;\n  placeholder: string;\n  helpUrl: string;', new_target, content)

with open('server/store.ts', 'w') as f:
    f.write(content)
