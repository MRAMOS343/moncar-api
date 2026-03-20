// tests/auth.test.ts
import request from "supertest";
import app from "../src/index";

describe("Auth endpoints", () => {
  describe("POST /api/v1/auth/login", () => {
    it("should return 400 if email is missing", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ password: "test123" });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it("should return 400 if password is missing", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "test@example.com" });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

  });

  describe("GET /api/v1/auth/me", () => {
    it("should return 401 without token", async () => {
      const res = await request(app).get("/api/v1/auth/me");

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });
  });
});
