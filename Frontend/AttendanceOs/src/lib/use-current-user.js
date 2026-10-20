import { api } from "@/api/client";

export default function useCurrentUser() {
  return api.auth.currentUser();
}
