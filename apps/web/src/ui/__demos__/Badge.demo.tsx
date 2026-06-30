import { Badge } from "../Badge";

const variants = ["success", "warning", "error", "info", "neutral"] as const;

export function BadgeDemo() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {variants.map((v) => (
        <Badge key={v} variant={v}>
          {v}
        </Badge>
      ))}
    </div>
  );
}
