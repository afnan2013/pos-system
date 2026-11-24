---
paths:
  - "api/src/modules/sales/**"
  - "api/src/modules/inventory/**"
---

# Sales and inventory: the concurrency-critical path

Reviewers of the assessment will test this hardest.
Every rule below exists to keep stock and receipt numbers correct when many sales hit one outlet at the same time.

## Creating a sale (one use case, one transaction)

1. **Check access:** the actor may sell at this outlet (outlet scope) and holds `sales.create`.
2. **Idempotency:** if an `Idempotency-Key` was sent and a sale with that key exists for the outlet, return it unchanged.
3. **Normalise lines:** merge duplicate menu items into one line, reject quantities below 1, then **sort by `menu_item_id`**.
   The sort fixes the lock order, so two concurrent sales can never deadlock on each other's rows.
4. **Price the lines** with one query over the outlet's assignments: unit price is the outlet override, else the master price.
   An item that is not assigned to the outlet, or is inactive, rejects the whole sale.
5. **Deduct stock line by line**, in that sorted order, with a conditional update:

   ```sql
   UPDATE pos.outlet_inventory
      SET quantity = quantity - :quantity!, updated_at = now()
    WHERE outlet_id = :outletId! AND menu_item_id = :menuItemId! AND quantity >= :quantity!
   RETURNING quantity;
   ```

   No row returned means not enough stock: throw `ErrInsufficientStock` (409) naming the item, and the transaction rolls back every earlier deduction.
6. **Take the receipt number last**, so the per-outlet counter row stays locked for the shortest time:

   ```sql
   UPDATE pos.outlet_receipt_counters
      SET last_number = last_number + 1
    WHERE outlet_id = :outletId!
   RETURNING last_number;
   ```

   The row lock makes concurrent sales at one outlet take numbers one after another; a rollback undoes the increment, so numbers have no gaps.
7. **Insert the sale and its lines**, with totals computed in the service in integer minor units and each line's unit price and item name frozen.
8. Commit, then respond `201` with the sale and its receipt number.

## Never

- `SELECT MAX(receipt_number) + 1`: two transactions read the same max and collide.
- A Postgres sequence for receipt numbers: sequences are not per outlet and leave gaps on rollback.
- Read-then-write stock checks (`SELECT quantity` then `UPDATE`): another sale can slip in between.
- Raising the isolation level as the fix: the conditional update and the counter row lock are the design.
- Any network call inside the sale transaction.

## Backstops in the schema

- `CHECK (quantity >= 0)` on `outlet_inventory`.
- `UNIQUE (outlet_id, receipt_number)` and `UNIQUE (outlet_id, idempotency_key)` on `sales`.
- A counter row is created for every outlet when the outlet is created, inside the same transaction.

## Inventory changes outside sales

- Restock and manual adjustments are their own use cases with their own permission, using the same conditional-update style.
- An adjustment that would take stock below zero is rejected, not clamped.
- Creating an assignment creates the inventory row at zero in the same transaction.

## Required tests (integration, real Postgres)

- 50 concurrent sales at one outlet: receipt numbers are exactly 1..50, no duplicates, no gaps.
- Concurrent sales racing for the last units: exactly the available quantity is sold, the rest get 409, stock ends at 0, never below.
- A sale with one line out of stock leaves every other line's stock unchanged.
- Sales at two outlets run concurrently with independent receipt sequences.
- The same `Idempotency-Key` sent twice creates one sale.
