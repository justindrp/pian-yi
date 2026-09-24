import Link from "next/link";
import {
  type CatalogKitchen,
  porsiRange,
  rupiah,
} from "@/lib/catalog/kitchens";

/** One kitchen in a list: its entry price, days, areas and options. */
export function KitchenCard({ kitchen }: { kitchen: CatalogKitchen }) {
  const top = kitchen.rungs[0];
  return (
    <li className="pl-kitchen">
      <Link href={`/menu/${kitchen.slug}`} className="pl-kitchen-link">
        <h3>{kitchen.nickname}</h3>
        <p className="pl-kitchen-price">
          <small>mulai</small>
          <span className="pl-num">Rp {rupiah(kitchen.from)}</span>
          <small>/porsi</small>
        </p>
        {top && (
          <p className="pl-kitchen-sub pl-num">
            {porsiRange(top.min, top.max)}: Rp {rupiah(top.price)}/porsi
          </p>
        )}
        <dl className="pl-kitchen-facts">
          <dt>Hari antar</dt>
          <dd>{kitchen.daysLabel}</dd>
          <dt>Area</dt>
          <dd>{kitchen.areas.join(", ")}</dd>
        </dl>
        {(kitchen.sizeM !== null || kitchen.noRiceOff > 0) && (
          <ul className="pl-chips">
            {kitchen.sizeM !== null && <li>Size M</li>}
            {kitchen.noRiceOff > 0 && <li>Tanpa nasi lebih hemat</li>}
          </ul>
        )}
      </Link>
    </li>
  );
}
