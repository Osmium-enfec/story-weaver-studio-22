CREATE POLICY "image_assets: owner update" ON public.image_assets FOR UPDATE TO authenticated USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);
CREATE POLICY "image_assets: owner delete" ON public.image_assets FOR DELETE TO authenticated USING (auth.uid() = created_by);
GRANT UPDATE, DELETE ON public.image_assets TO authenticated;