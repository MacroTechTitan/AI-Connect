import { Button } from "../Button";
import { useToast } from "../Toast";

export function ToastDemo() {
  const { toast } = useToast();
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <Button
        variant="primary"
        onClick={() =>
          toast.success({ title: "Saved", description: "Your changes were saved." })
        }
      >
        Success
      </Button>
      <Button
        variant="danger"
        onClick={() =>
          toast.error({ title: "Error", description: "Something went wrong." })
        }
      >
        Error
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast.info({ title: "Heads up", description: "Just so you know." })
        }
      >
        Info
      </Button>
      <Button
        variant="ghost"
        onClick={() =>
          toast.warning({
            title: "Careful",
            description: "This is a warning with an action.",
            action: { label: "Undo", onClick: () => undefined },
          })
        }
      >
        Warning + action
      </Button>
    </div>
  );
}
