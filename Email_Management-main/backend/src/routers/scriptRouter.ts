import { Router } from "express";
import {
  createScriptFile,
  deleteScriptFile,
  getScriptCompany,
  listScriptCompanies,
  listScriptFiles,
  saveCompanyScript,
} from "../controllers/scriptController";

const app = Router();

app.post("/script-files", createScriptFile);
app.get("/script-files", listScriptFiles);
app.get("/script-files/:id/companies", listScriptCompanies);
app.delete("/script-files/:id", deleteScriptFile);
app.get("/script-companies/:id", getScriptCompany);
app.put("/script-companies/:id/scripts/:type", saveCompanyScript);

export default app;
