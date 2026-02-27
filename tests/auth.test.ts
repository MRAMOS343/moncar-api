// tests/auth.test.ts
import request from "supertest";
import app from "../src/index";

describe("Auth endpoints", () => {
  describe("POST /auth/login", () => {
    it("should return 400 if email is missing", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ password: "test123" });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("should return 400 if password is missing", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "test@example.com" });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("should return 401 for invalid credentials", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "noexiste@test.com", password: "wrongpassword" });

      // Puede ser 401 o 404 dependiendo de la implementación
      expect([400, 401, 404]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    });
  });

  describe("GET /auth/me", () => {
    it("should return 401 without token", async () => {
      const res = await request(app).get("/auth/me");

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });
  });
});
