import { Card } from "../Card";

export function CardDemo() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 16,
      }}
    >
      <Card
        variant="default"
        header={<strong>Default</strong>}
        footer={<small>Footer</small>}
      >
        Default card body with header and footer.
      </Card>
      <Card variant="elevated">Elevated card with a drop shadow.</Card>
      <Card variant="outlined">Outlined card, transparent background.</Card>
      <Card interactive onClick={() => undefined}>
        Interactive card — hover to lift.
      </Card>
    </div>
  );
}
