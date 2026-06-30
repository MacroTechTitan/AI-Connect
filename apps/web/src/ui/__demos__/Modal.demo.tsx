import { useState } from "react";

import { Button } from "../Button";
import { Modal } from "../Modal";

export function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Example modal"
        size="md"
      >
        <p>
          This modal closes on backdrop click, the Escape key, or the × button.
          Tab and Shift+Tab are trapped inside.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpen(false)}>Confirm</Button>
        </div>
      </Modal>
    </>
  );
}
