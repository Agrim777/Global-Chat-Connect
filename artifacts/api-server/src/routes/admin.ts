import { Router } from "express";

const router = Router();

const ADMIN_KEY = process.env.ADMIN_TELEGRAM_ID ?? "8273572245";

function isAdminKey(key: unknown) {
  return typeof key === "string" && key === ADMIN_KEY;
}

router.get("/admin/broadcast", async (req, res) => {
  if (!isAdminKey(req.query["key"])) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  res.status(410).json({ status: "disabled", message: "Broadcast is disabled for safety" });
});

router.get("/admin/broadcast/status", async (req, res) => {
  if (!isAdminKey(req.query["key"])) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  res.json({ running: false, disabled: true });
});

router.get("/admin/broadcast/new", async (req, res) => {
  if (!isAdminKey(req.query["key"])) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  res.status(410).json({ status: "disabled", message: "New-user broadcast is disabled for safety" });
});

export default router;
