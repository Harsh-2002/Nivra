import { ArrowRight, Menu } from "lucide-react";

export function NavigationIcon() {
  return (
    <>
      <ArrowRight
        className="navigation-expand-icon"
        size={18}
        aria-hidden="true"
      />
      <Menu className="navigation-menu-icon" size={18} aria-hidden="true" />
    </>
  );
}
