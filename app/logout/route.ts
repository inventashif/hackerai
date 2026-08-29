import { signOut } from "@workos-inc/authkit-nextjs";
import { isPersonalMode } from "@/lib/auth/personal-mode";

export const GET = async () => {
  if (isPersonalMode()) {
    const { signOut: personalSignOut } = await import(
      "@/lib/auth/personal-authkit"
    );
    return personalSignOut();
  }

  return signOut();
};
