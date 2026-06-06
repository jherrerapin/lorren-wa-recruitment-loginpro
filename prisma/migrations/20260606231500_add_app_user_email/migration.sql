-- Add email field to AppUser for personalized reply-to in dispatch emails
ALTER TABLE "AppUser" ADD COLUMN "email" TEXT;
