import type { AuthUser } from "./middleware/auth.js";

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};
