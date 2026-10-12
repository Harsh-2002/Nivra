import { FeedbackOutlet } from "./inline-feedback";
import { NavigationIcon } from "./navigation-icon";
import { Button } from "./ui/button";

export function SectionHeading({
  title,
  description,
  onNavigation,
}: {
  title: string;
  description: string;
  onNavigation: () => void;
}) {
  return (
    <header className="section-heading">
      <div className="section-heading-title">
        <h1>{title}</h1>
        <Button
          variant="ghost"
          size="icon"
          className="menu-toggle"
          aria-label="Open navigation"
          onClick={onNavigation}
        >
          <NavigationIcon />
        </Button>
      </div>
      <p>{description}</p>
      <FeedbackOutlet />
    </header>
  );
}
