import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  NAMED_REMOTE_URL,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "@/lib/remote-access";
import { Card, CopyableValue } from "./SettingsPrimitives";

export function RemoteAccessSection() {
  return (
    <Card title={REMOTE_ACCESS_HEADING} subtitle={sentenceGapHtml(REMOTE_ACCESS_BLURB)}>
      <CopyableValue label={REMOTE_URL_LABEL} value={NAMED_REMOTE_URL} />
    </Card>
  );
}

export function CompanionGatewayCard() {
  return <Card title={COMPANION_GATEWAY_LABEL} subtitle={sentenceGapHtml(COMPANION_GATEWAY_BLURB)} />;
}
