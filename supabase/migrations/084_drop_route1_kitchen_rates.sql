-- The Pian Yi courier stops on 2026-09-01. Every kitchen now delivers its own
-- routes, so route 1 no longer buys us a cheaper portion — it was the discount
-- for the runs our courier did.
--
-- kitchenCostPerPortion() reads the route-1 columns and falls back to the
-- kitchen's own rate when they are null, so nulling them is how a kitchen says
-- "one rate, whichever route". Left as columns rather than dropped: the split
-- is a real thing a future kitchen could quote again, and the fallback already
-- handles its absence.
--
-- For Thenie (Dapur 1) this makes every route S Rp 21.000 and M Rp 24.000 —
-- was 19.500 / 23.000 on route 1.
update subcontractors
set cost_per_portion_route1 = null,
    cost_per_portion_route1_m = null
where cost_per_portion_route1 is not null
   or cost_per_portion_route1_m is not null;
