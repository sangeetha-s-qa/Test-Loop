import { describe, expect, it } from "vitest";
import { otpEmail, passwordChangedEmail } from "./mailer";
import { challengeResponse, maskEmail } from "./otp";

describe("OTP email helpers", () => {
  it("masks an address enough to recognise but not to harvest", () => {
    expect(maskEmail("dev@techinorm.com")).toBe("d**@techinorm.com");
    expect(maskEmail("a@b.co")).toBe("a**@b.co");
    expect(maskEmail("sangeetha.s@company.com")).toBe("s******@company.com");
  });

  it("puts the code in both parts and names its purpose", () => {
    const mail = otpEmail("SIGN_IN", "Dev", "042917", 10);
    expect(mail.subject).toBe("Your Testloop sign-in code");
    expect(mail.text).toContain("042917");
    expect(mail.html).toContain("042917");
    expect(mail.text).toContain("expires in 10 minutes");
    expect(mail.text).toMatch(/reset it now/);
    expect(otpEmail("PASSWORD_RESET", "Dev", "000001", 10).subject).toBe("Reset your Testloop password");
  });

  it("escapes the recipient's name in HTML", () => {
    expect(otpEmail("SIGNUP_VERIFICATION", '<img src=x onerror="1">', "123456", 10).html).not.toContain("<img");
    expect(passwordChangedEmail("<b>x</b>").html).not.toContain("<b>x</b>");
  });

  it("describes a challenge without the code", () => {
    const response = challengeResponse("4f7d8f0e-5d0c-4b8f-9a1e-1d2c3b4a5f60", "dev@techinorm.com");
    expect(response).toEqual({ otpRequired: true, challengeId: "4f7d8f0e-5d0c-4b8f-9a1e-1d2c3b4a5f60", email: "d**@techinorm.com", expiresInSeconds: 600, resendAfterSeconds: 2 });
  });
});
