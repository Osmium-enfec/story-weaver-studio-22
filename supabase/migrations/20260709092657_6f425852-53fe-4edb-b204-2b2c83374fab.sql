
drop policy if exists "image_assets: authenticated users can bump usage" on public.image_assets;

-- Make bump function security-definer so it doesn't need an UPDATE policy
create or replace function public.bump_image_asset_usage(asset_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.image_assets set usage_count = usage_count + 1 where id = asset_id;
$$;

grant execute on function public.bump_image_asset_usage(uuid) to authenticated;
