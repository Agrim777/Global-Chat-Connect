import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import chatRouter from "./chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(chatRouter);

export default router;
