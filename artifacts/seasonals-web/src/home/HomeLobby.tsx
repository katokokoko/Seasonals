/**
 * HomeLobby — lobby / overview (UI v2 §3)。中央に Calendar / Timeline カード、
 * 四隅に Agent / Menu / Setting / Dashboard の portal card。
 * quiet zone は nav + 中央 + 左列 + 右列 の 4 rect (WORKLOG #7)。
 */
import { HomeCalendarCard } from "./HomeCalendarCard";
import { PortalCard } from "./PortalCard";
import { IconGear, IconLeaf, IconMenuGrid, IconPie } from "../ui/icons";
import "./home.css";

export function HomeLobby() {
  return (
    <div className="lobby">
      <h1 className="sr-only">Seasonals overview</h1>
      <PortalCard to="/agent" title="Agent" description="Your seasonal companion" icon={<IconLeaf size={30} />} slot="agent" />
      <PortalCard to="/explore" title="Menu" description="Explore Seasonals" icon={<IconMenuGrid size={30} />} slot="menu" />
      <HomeCalendarCard />
      <PortalCard to="/settings" title="Setting" description="Make it yours" icon={<IconGear size={30} />} slot="setting" />
      <PortalCard to="/dashboard" title="Dashboard" description="Your seasonal snapshot" icon={<IconPie size={30} />} slot="dashboard" />
    </div>
  );
}
