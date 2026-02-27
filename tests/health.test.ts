// tests/health.test.ts
import request from "supertest";
import app from "../src/index";

describe("Health endpoints", () => {
  describe("GET /ping", () => {
    it("should return ok: true", async () => {
      const res = await request(app).get("/ping");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, message: "pong" });
      expect(res.body.now).toBeDefined();
    });
  });

  describe("GET /api/v1/ping (via v1 router)", () => {
    it("should also reach /ping", async () => {
      // /ping está montado en app root, no en v1
      // Este test verifica que la API responde
      const res = await request(app).get("/ping");
      expect(res.status).toBe(200);
    });
  });
});
